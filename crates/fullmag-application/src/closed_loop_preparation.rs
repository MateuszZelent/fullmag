//! Accepted inspection preparation has no magnetic grid or LLG certificates.
use crate::{AcceptedRunPreparationSource, PreparationBinding, PreparationReceipt, RunSpecification};
use fullmag_authoring::StudyStepKind;
use fullmag_ir::ProblemIR;
use fullmag_plan::{NativeFemMeshSpaceEvidence, StudyStepExecutionPlan};
use serde::{Deserialize, Serialize};

pub const CLOSED_LOOP_PREPARATION_SCHEMA: &str = "closed_loop_preparation_receipt.v1";
pub const CLOSED_LOOP_PREPARATION_BINDING_SCHEMA: &str = "closed_loop_preparation_binding.v1";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ClosedLoopPreparationPlan {
    pub schema_version: String,
    pub source: AcceptedRunPreparationSource,
    pub problem_fingerprint: String,
    pub carrier_fingerprint: String,
    pub operation_fingerprint: String,
    pub source_mesh_fingerprint: String,
    pub stage_id: String,
    pub port_mode_id: String,
    pub output_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ClosedLoopPreparationReceipt {
    pub schema_version: String,
    pub preparation_id: String,
    pub plan_fingerprint: String,
    pub plan: ClosedLoopPreparationPlan,
    pub native: NativeFemMeshSpaceEvidence,
}

fn failure(message: impl Into<String>) -> crate::PreparationReceiptError {
    crate::PreparationReceiptError::Contract(message.into())
}
fn fingerprint(value: &impl Serialize) -> Result<String, crate::PreparationReceiptError> {
    crate::preparation::fingerprint_json(value).map_err(|error| failure(error.to_string()))
}

/// The session owner supplies its canonical task identity; application does not derive store IDs.
fn preparation_id_for_task(canonical_task_id: &str) -> Result<String, crate::PreparationReceiptError> {
    crate::TaskId::parse(canonical_task_id.to_owned()).map_err(|error| failure(error.to_string()))?;
    Ok(format!("prep-{canonical_task_id}"))
}

fn validate_preparation_task_identity(preparation_id: &str, canonical_task_id: &str) -> Result<(), crate::PreparationReceiptError> {
    if preparation_id != preparation_id_for_task(canonical_task_id)? {
        return Err(failure("inspection preparation does not belong to the canonical accepted task"));
    }
    Ok(())
}

impl ClosedLoopPreparationReceipt {
    pub fn ready(specification: &RunSpecification, canonical_task_id: &str, step: &StudyStepExecutionPlan, problem: &ProblemIR, native: NativeFemMeshSpaceEvidence) -> Result<Self, crate::PreparationReceiptError> {
        let preparation_id = preparation_id_for_task(canonical_task_id)?;
        let plan = Self::expected_plan(specification, step, problem)?;
        let receipt = Self { schema_version: CLOSED_LOOP_PREPARATION_SCHEMA.into(), preparation_id, plan_fingerprint: fingerprint(&plan)?, plan, native };
        receipt.validate_for(specification, canonical_task_id, step, problem)?;
        Ok(receipt)
    }

    fn expected_plan(specification: &RunSpecification, step: &StudyStepExecutionPlan, problem: &ProblemIR) -> Result<ClosedLoopPreparationPlan, crate::PreparationReceiptError> {
        let StudyStepKind::ClosedLoopInspection { stage_id, port_mode_id, output_id } = &step.kind else { return Err(failure("operation preparation requires a typed closed-loop step")); };
        if specification.study.plan_version != fullmag_authoring::STUDY_PLAN_SCHEMA_VERSION_V4 || !step.enabled || step.until_seconds.is_some() || !step.inputs.is_empty() { return Err(failure("operation preparation requires an enabled v4 inspection without horizon/state")); }
        let operation = fullmag_plan::validate_closed_loop_operation(problem, stage_id, port_mode_id, output_id).map_err(|error| failure(error.to_string()))?;
        let fullmag_plan::AntennaFieldSolveExecutionPlan::ClosedLoopInspection { input, requested_execution, output_id } = operation else { return Err(failure("inspection preparation selected another physical operation")); };
        let carrier = fullmag_plan::plan(problem).map_err(|error| failure(error.to_string()))?;
        if step.execution_plan.as_ref() != Some(&carrier) { return Err(failure("operation preparation carrier differs from accepted lowering")); }
        let problem_fingerprint = fingerprint(problem)?;
        Ok(ClosedLoopPreparationPlan { schema_version: "closed_loop_preparation_plan.v1".into(), source: AcceptedRunPreparationSource::for_study_step(specification, &step.step_id, &problem_fingerprint)?, problem_fingerprint, carrier_fingerprint: fingerprint(&carrier)?, operation_fingerprint: fingerprint(&serde_json::json!({"input":&input,"requested_execution":&requested_execution,"output_id":&output_id}))?, source_mesh_fingerprint: input.source_mesh.topology_fingerprint_v6(), stage_id: stage_id.clone(), port_mode_id: port_mode_id.clone(), output_id })
    }

    pub fn validate_for(&self, specification: &RunSpecification, canonical_task_id: &str, step: &StudyStepExecutionPlan, problem: &ProblemIR) -> Result<(), crate::PreparationReceiptError> {
        validate_preparation_task_identity(&self.preparation_id, canonical_task_id)?;
        self.validate()?;
        if self.plan != Self::expected_plan(specification, step, problem)? { return Err(failure("inspection preparation does not match immutable accepted source")); }
        let operation = fullmag_plan::validate_closed_loop_operation(problem, &self.plan.stage_id, &self.plan.port_mode_id, &self.plan.output_id).map_err(|error| failure(error.to_string()))?;
        let fullmag_plan::AntennaFieldSolveExecutionPlan::ClosedLoopInspection { input, .. } = operation else { return Err(failure("inspection preparation operation mismatch")); };
        self.native.validate_for_mesh(&input.source_mesh, 1).map_err(|error| failure(error.to_string()))?;
        Ok(())
    }

    pub fn validate(&self) -> Result<(), crate::PreparationReceiptError> {
        if self.schema_version != CLOSED_LOOP_PREPARATION_SCHEMA || self.plan.schema_version != "closed_loop_preparation_plan.v1" || self.plan_fingerprint != fingerprint(&self.plan)? { return Err(failure("inspection preparation schema or plan digest mismatch")); }
        self.plan.source.validate()?;
        if self.plan.problem_fingerprint != self.plan.source.problem_fingerprint || self.plan.source_mesh_fingerprint != self.native.canonical_mesh_fingerprint { return Err(failure("inspection preparation native source identity mismatch")); }
        for digest in [&self.plan.problem_fingerprint, &self.plan.carrier_fingerprint, &self.plan.operation_fingerprint, &self.plan.source_mesh_fingerprint] {
            if !digest.strip_prefix("sha256:").is_some_and(|hex| hex.len()==64 && hex.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))) { return Err(failure("inspection preparation digest must be prefixed lowercase sha256")); }
        }
        self.binding()?;
        Ok(())
    }

    pub fn binding(&self) -> Result<PreparationBinding, crate::PreparationReceiptError> {
        let binding = PreparationBinding { schema_version: CLOSED_LOOP_PREPARATION_BINDING_SCHEMA.into(), preparation_id: self.preparation_id.clone(), plan_fingerprint: self.plan_fingerprint.clone(), receipt_sha256: fingerprint(self)? };
        binding.validate()?;
        Ok(binding)
    }
}

/// Two concrete readiness records, with their distinct immutable wire schemas.
#[derive(Debug, Clone)]
pub enum AcceptedPreparationReceipt {
    Solver(PreparationReceipt),
    ClosedLoop(ClosedLoopPreparationReceipt),
}
impl AcceptedPreparationReceipt {
    pub fn binding(&self) -> Result<PreparationBinding, crate::PreparationReceiptError> {
        match self { Self::Solver(receipt) => PreparationBinding::from_receipt(receipt), Self::ClosedLoop(receipt) => { receipt.validate()?; receipt.binding() } }
    }
    pub fn preparation_id(&self) -> &str { match self { Self::Solver(receipt) => &receipt.preparation_id, Self::ClosedLoop(receipt) => &receipt.preparation_id } }
    pub fn plan_fingerprint(&self) -> &str { match self { Self::Solver(receipt) => &receipt.plan_fingerprint, Self::ClosedLoop(receipt) => &receipt.plan_fingerprint } }
    pub fn payload(&self) -> Result<serde_json::Value, serde_json::Error> { match self { Self::Solver(receipt) => serde_json::to_value(receipt), Self::ClosedLoop(receipt) => serde_json::to_value(receipt) } }
    pub fn source(&self) -> Result<&AcceptedRunPreparationSource, crate::PreparationReceiptError> {
        match self { Self::Solver(receipt) => receipt.accepted_run_source.as_ref().ok_or_else(|| failure("accepted preparation has no source")), Self::ClosedLoop(receipt) => Ok(&receipt.plan.source) }
    }
}

/// The coordinator validates a concrete receipt before emitting its compact binding.
mod sealed {
    pub trait Sealed {}
    impl Sealed for crate::PreparationReceipt {}
    impl Sealed for super::AcceptedPreparationReceipt {}
}
pub trait AcceptedPreparationProof: sealed::Sealed {
    fn accepted_binding(&self) -> Result<PreparationBinding, crate::PreparationReceiptError>;
}
impl AcceptedPreparationProof for PreparationReceipt {
    fn accepted_binding(&self) -> Result<PreparationBinding, crate::PreparationReceiptError> { PreparationBinding::from_receipt(self) }
}
impl AcceptedPreparationProof for AcceptedPreparationReceipt {
    fn accepted_binding(&self) -> Result<PreparationBinding, crate::PreparationReceiptError> { self.binding() }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preparation_identity_uses_canonical_task_instead_of_authored_execution_id() {
        let task_id=format!("task-{}","a".repeat(64));
        let execution_id=format!("script-execution-{}","b".repeat(64));
        let expected=preparation_id_for_task(&task_id).unwrap();
        assert_eq!(expected,format!("prep-{task_id}"));
        validate_preparation_task_identity(&expected,&task_id).unwrap();
        assert!(validate_preparation_task_identity(&format!("prep-{execution_id}"),&task_id).is_err());
        assert!(validate_preparation_task_identity(&expected,&format!("task-{}","c".repeat(64))).is_err());
    }
    #[test]
    fn malformed_task_identity_cannot_create_an_operation_preparation_id() {
        for invalid in ["","../task","task/foreign"] {assert!(preparation_id_for_task(invalid).is_err());}
    }
}
