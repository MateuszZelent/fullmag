//! Parent-bound H-only readiness. DTO consistency never authenticates durable source history.
use crate::{AcceptedRunPreparationSource, PreparationBinding, PreparationReceiptError, RunSpecification};
use fullmag_antenna_artifacts::retained_current::RetainedCurrentParent;
use fullmag_authoring::{StudyAcceptancePolicy, StudyAcquisitionPolicy, StudyOutputPort, StudyPortDataKind, StudyStepKind};
use fullmag_ir::ProblemIR;
use fullmag_plan::{StudyStepExecutionPlan, StudyStepLoweringStatus};
use serde::{Deserialize, Serialize};

pub const RETAINED_CURRENT_PREPARATION_PLAN_SCHEMA: &str = "retained_current_preparation_plan.v1";
pub const RETAINED_CURRENT_PREPARATION_SCHEMA: &str = "retained_current_preparation_receipt.v1";
pub const RETAINED_CURRENT_PREPARATION_BINDING_SCHEMA: &str = "retained_current_preparation_binding.v1";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct RetainedCurrentPreparationPlan {
    pub schema_version: String,
    pub source: AcceptedRunPreparationSource,
    pub problem_fingerprint: String,
    pub carrier_fingerprint: String,
    pub operation_fingerprint: String,
    pub sampling_fingerprint: String,
    pub stage_id: String,
    pub port_mode_id: String,
    pub output_id: String,
    pub parent: RetainedCurrentParent,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct RetainedCurrentPreparationReceipt {
    pub schema_version: String,
    pub preparation_id: String,
    pub plan_fingerprint: String,
    pub plan: RetainedCurrentPreparationPlan,
}

fn failure(message: impl Into<String>) -> PreparationReceiptError {
    PreparationReceiptError::Contract(message.into())
}
fn fingerprint(value: &impl Serialize) -> Result<String, PreparationReceiptError> {
    crate::preparation::fingerprint_json(value).map_err(|error| failure(error.to_string()))
}
fn preparation_id_for_task(task_id: &str) -> Result<String, PreparationReceiptError> {
    crate::TaskId::parse(task_id.to_owned()).map_err(|error| failure(error.to_string()))?;
    Ok(format!("prep-{task_id}"))
}
fn identifier(value: &str) -> bool {
    !value.is_empty() && value.len() <= 4096 && value.trim() == value
        && !value.chars().any(char::is_control)
}
fn digest(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(|hex| hex.len() == 64
        && hex.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)))
}

impl RetainedCurrentPreparationReceipt {
    /// The caller must obtain `parent` from the durable authenticated reader and compare source intent.
    pub fn ready(
        specification: &RunSpecification,
        canonical_task_id: &str,
        step: &StudyStepExecutionPlan,
        problem: &ProblemIR,
        parent: RetainedCurrentParent,
    ) -> Result<Self, PreparationReceiptError> {
        let plan = Self::expected_plan(specification, step, problem, &parent)?;
        let receipt = Self {
            schema_version: RETAINED_CURRENT_PREPARATION_SCHEMA.into(),
            preparation_id: preparation_id_for_task(canonical_task_id)?,
            plan_fingerprint: fingerprint(&plan)?,
            plan,
        };
        receipt.validate_for(specification, canonical_task_id, step, problem, &parent)?;
        Ok(receipt)
    }

    fn expected_plan(
        specification: &RunSpecification,
        step: &StudyStepExecutionPlan,
        problem: &ProblemIR,
        parent: &RetainedCurrentParent,
    ) -> Result<RetainedCurrentPreparationPlan, PreparationReceiptError> {
        let StudyStepKind::RetainedCurrentFieldInspection { stage_id, port_mode_id, output_id } = &step.kind else {
            return Err(failure("retained-current preparation requires its typed H-only operation"));
        };
        if specification.study.plan_version != fullmag_authoring::STUDY_PLAN_SCHEMA_VERSION_V4
            || !step.enabled || step.status != StudyStepLoweringStatus::Planned
            || step.until_seconds.is_some() || !step.inputs.is_empty()
            || step.outputs != [StudyOutputPort { port_id: "inspection".into(), data_kind: StudyPortDataKind::Artifact }]
            || step.acceptance != StudyAcceptancePolicy::Any
            || step.acquisition != StudyAcquisitionPolicy::Exclusive {
            return Err(failure("retained-current preparation requires an enabled planned v4 static inspection with Any/Exclusive and one inspection Artifact output"));
        }
        parent.validate_metadata().map_err(|error| failure(error.to_string()))?;
        if parent.owner.project_id != specification.snapshot.project_id.as_str() {
            return Err(failure("retained-current parent belongs to another accepted project"));
        }
        let operation = fullmag_plan::validate_retained_current_field_operation(
            problem, stage_id, port_mode_id, output_id,
        ).map_err(|error| failure(error.to_string()))?;
        let source = operation.stage.retained_current_source.as_ref()
            .ok_or_else(|| failure("retained-current operation has no source locator"))?;
        if !parent.owner.matches_source(source) {
            return Err(failure("retained-current parent differs from the exact authored historical source locator"));
        }
        let carrier = fullmag_plan::plan(problem).map_err(|error| failure(error.to_string()))?;
        if step.execution_plan.as_ref() != Some(&carrier) {
            return Err(failure("retained-current preparation carrier differs from immutable accepted lowering"));
        }
        let problem_fingerprint = fingerprint(problem)?;
        Ok(RetainedCurrentPreparationPlan {
            schema_version: RETAINED_CURRENT_PREPARATION_PLAN_SCHEMA.into(),
            source: AcceptedRunPreparationSource::for_study_step(specification, &step.step_id, &problem_fingerprint)?,
            problem_fingerprint,
            carrier_fingerprint: fingerprint(&carrier)?,
            operation_fingerprint: fingerprint(&operation)?,
            sampling_fingerprint: fingerprint(&operation.field_sampling)?,
            stage_id: stage_id.clone(), port_mode_id: port_mode_id.clone(), output_id: output_id.clone(),
            parent: parent.clone(),
        })
    }

    /// `expected_parent` is independently loaded; this receipt cannot authorize its own parent pins.
    pub fn validate_for(
        &self,
        specification: &RunSpecification,
        canonical_task_id: &str,
        step: &StudyStepExecutionPlan,
        problem: &ProblemIR,
        expected_parent: &RetainedCurrentParent,
    ) -> Result<(), PreparationReceiptError> {
        expected_parent.validate_metadata().map_err(|error| failure(error.to_string()))?;
        if &self.plan.parent != expected_parent {
            return Err(failure("retained-current preparation differs from independently loaded parent evidence"));
        }
        self.validate_for_accepted_input(specification, canonical_task_id, step, problem)
    }

    /// Check stored pins against canonical accepted input, without authenticating historical source state.
    /// The preparer and worker must additionally use `validate_for` with independently loaded evidence.
    pub fn validate_for_accepted_input(
        &self,
        specification: &RunSpecification,
        canonical_task_id: &str,
        step: &StudyStepExecutionPlan,
        problem: &ProblemIR,
    ) -> Result<(), PreparationReceiptError> {
        self.validate()?;
        if self.preparation_id != preparation_id_for_task(canonical_task_id)? {
            return Err(failure("retained-current preparation does not belong to the canonical accepted task"));
        }
        if self.plan != Self::expected_plan(specification, step, problem, &self.plan.parent)? {
            return Err(failure("retained-current preparation differs from immutable accepted source or sampling"));
        }
        Ok(())
    }

    /// Shape and own hashes only; no filesystem read, source authentication or numerical qualification.
    pub fn validate(&self) -> Result<(), PreparationReceiptError> {
        if self.schema_version != RETAINED_CURRENT_PREPARATION_SCHEMA
            || self.plan.schema_version != RETAINED_CURRENT_PREPARATION_PLAN_SCHEMA
            || self.plan_fingerprint != fingerprint(&self.plan)? {
            return Err(failure("retained-current preparation schema or plan digest mismatch"));
        }
        let task_id = self.preparation_id.strip_prefix("prep-")
            .ok_or_else(|| failure("retained-current preparation has no canonical task identity"))?;
        preparation_id_for_task(task_id)?;
        self.plan.source.validate()?;
        self.plan.parent.validate_metadata().map_err(|error| failure(error.to_string()))?;
        if self.plan.problem_fingerprint != self.plan.source.problem_fingerprint
            || [&self.plan.stage_id, &self.plan.port_mode_id, &self.plan.output_id]
                .into_iter().any(|value| !identifier(value))
            || [&self.plan.problem_fingerprint, &self.plan.carrier_fingerprint,
                &self.plan.operation_fingerprint, &self.plan.sampling_fingerprint]
                .into_iter().any(|value| !digest(value)) {
            return Err(failure("retained-current preparation identity or canonical fingerprint mismatch"));
        }
        self.binding()?;
        Ok(())
    }

    /// The binding covers the complete receipt, including every historical parent pin and byte count.
    pub fn binding(&self) -> Result<PreparationBinding, PreparationReceiptError> {
        let binding = PreparationBinding {
            schema_version: RETAINED_CURRENT_PREPARATION_BINDING_SCHEMA.into(),
            preparation_id: self.preparation_id.clone(),
            plan_fingerprint: self.plan_fingerprint.clone(),
            receipt_sha256: fingerprint(self)?,
        };
        binding.validate()?;
        Ok(binding)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use fullmag_antenna_artifacts::retained_current::{
        CasObjectRef, ParentCurrentDigests, ParentInspectionOwner,
        PARENT_CODEC_ID, PARENT_CODEC_VERSION, PARENT_MANIFEST_SCHEMA,
    };
    use serde_json::{json, Value};

    fn hash(value: char) -> String { value.to_string().repeat(64) }
    fn pin(value: char) -> String { format!("sha256:{}", hash(value)) }
    fn parent() -> RetainedCurrentParent {
        // Shape fixture only: no durable task, current solve or numerical qualification.
        RetainedCurrentParent {
            owner: ParentInspectionOwner {
                project_id:"project-source".into(), run_id:"run-source".into(),
                study_step_id:"historical-step".into(), native_stage_id:"historical-stage".into(),
                task_id:"task-source".into(), attempt_id:"attempt-source".into(),
                ownership_epoch:"1".into(), artifact_id:"artifact-source".into(),
                package:CasObjectRef {object_ref:hash('a'),byte_count:4096},
                package_codec_id:PARENT_CODEC_ID.into(), package_codec_version:PARENT_CODEC_VERSION.into(),
                manifest_schema:PARENT_MANIFEST_SCHEMA.into(), output_manifest_artifact_id:"manifest-source".into(),
                output_manifest:CasObjectRef {object_ref:hash('b'),byte_count:512},
            },
            source:ParentCurrentDigests {
                prepared_execution_digest:pin('1'), accepted_charge_field_digest:pin('2'),
                accepted_source_state_digest:pin('3'), view_identity_digest:pin('4'),
                current_balance_certificate_digest:pin('5'),
            },
            evidence_capsule:CasObjectRef {object_ref:hash('c'),byte_count:2048},
        }
    }
    fn problem() -> ProblemIR {
        let mut wire:Value=serde_json::from_str(include_str!(
            "../../../tests/fixtures/runtime/antenna-standalone-pipeline.json")).unwrap();
        let ir=&mut wire["ir"];
        ir["study"]["selection"]=json!({"stage_id":"inspect_antenna","port_mode_id":"port"});
        ir["geometry_assets"]["fem_mesh_assets"].as_array_mut().unwrap()
            .retain(|asset|asset["geometry_name"]=="probe");
        let stage=&mut ir["antenna_field_solve_stages"][0];
        stage["retained_current_source"]=json!({"kind":"published_inspection","project_id":"project-source",
            "run_id":"run-source","task_id":"task-source","attempt_id":"attempt-source",
            "ownership_epoch":"1","artifact_id":"artifact-source","object_ref":hash('a')});
        stage["oersted_realization"]=json!("analytic_rt0_surface");
        stage["surface_field_policy"]=json!({
            "policy_version":fullmag_ir::ANTENNA_SURFACE_FIELD_POLICY_VERSION,
            "limits":{"total":vec![1_000_000_u64;14],"per_target":vec![100_000_u64;14],
                "maximum_raw_integer_bits":8192,"maximum_reduced_fraction_bits":8192,
                "maximum_lifetime_peak_rss_bytes":268435456,"guard_interval_events":128,
                "maximum_total_seconds":600.0,"maximum_target_seconds":120.0},
            "tolerances":{"absolute_field_apm":1e-9,"relative_field":1e-5,"cancellation_floor_apm":1e-6,
                "scalar_relative_80":1e-45,"scalar_relative_120":1e-55,"angle_relative_80":1e-45,"angle_relative_120":1e-55,
                "binary_scalar_epsilon_factor":16.0,"binary_roundoff_epsilon_factor":64.0,
                "binary_cancellation_limit":1e8,"highprecision_cancellation_limit":1e40}
        });
        serde_json::from_value(ir.take()).unwrap()
    }
    fn specification() -> RunSpecification {
        let mut spec=RunSpecification::new(
            crate::ProjectSnapshot {project_id:crate::ProjectId::parse("project-source").unwrap(),
                definition_revision:1,definition_sha256:hash('d')},
            crate::StudyReference {study_id:crate::StudyId::parse("study-inspection").unwrap(),
                plan_version:fullmag_authoring::STUDY_PLAN_SCHEMA_VERSION_V4.into(),plan_sha256:hash('e')},
            hash('f'),json!({}),crate::RequestedExecution {backend:"fem".into(),device:"cpu".into(),
                precision:"double".into(),mode:"strict".into(),minimum_resources:Some(crate::RequestedResourceBudget {
                    cpu_millis:1000,memory_bytes:268435456,gpu_memory_bytes:0,storage_bytes:536870912})});
        spec.run_id=crate::RunId::parse("run-new-inspection").unwrap();
        spec
    }
    fn step(problem:&ProblemIR) -> StudyStepExecutionPlan {
        serde_json::from_value(json!({
            "step_id":"accepted-step","label":"Retained current field","enabled":true,"status":"planned",
            "kind":{"kind":"retained_current_field_inspection","stage_id":"inspect_antenna","port_mode_id":"port","output_id":"inspection"},
            "model":{"model_id":"model","version":"v1"},"solver_config":{"preset_id":"solver","version":"v1"},
            "discretization":{"recipe_id":"mesh","version":"v1"},"execution_profile":{"profile_id":"cpu","version":"v1"},
            "inputs":[],"outputs":[{"port_id":"inspection","data_kind":"artifact"}],
            "acceptance":{"kind":"any"},"acquisition":"exclusive","execution_plan":fullmag_plan::plan(problem).unwrap(),
        })).unwrap()
    }
    fn ready(problem:&ProblemIR) -> RetainedCurrentPreparationReceipt {
        RetainedCurrentPreparationReceipt::ready(&specification(),"task-accepted",&step(problem),problem,parent()).unwrap()
    }

    #[test]
    fn readiness_is_parent_bound_without_native_mesh_or_magnetic_certificates() {
        let problem=problem();let receipt=ready(&problem);
        receipt.validate_for(&specification(),"task-accepted",&step(&problem),&problem,&parent()).unwrap();
        assert_eq!(receipt.preparation_id,"prep-task-accepted");
        assert_ne!(receipt.plan.source.run_id.as_str(),receipt.plan.parent.owner.run_id);
        let wire=serde_json::to_value(&receipt).unwrap();
        assert!(wire.get("native").is_none());assert!(wire.get("certificates").is_none());
        assert_eq!(serde_json::from_value::<RetainedCurrentPreparationReceipt>(wire.clone()).unwrap(),receipt);
        let mut invalid=wire;invalid["native"]=json!({});
        assert!(serde_json::from_value::<RetainedCurrentPreparationReceipt>(invalid).is_err());
        let wrapped=crate::AcceptedPreparationReceipt::RetainedCurrent(receipt.clone());
        assert_eq!(wrapped.binding().unwrap(),receipt.binding().unwrap());
        assert_eq!(wrapped.source().unwrap(),&receipt.plan.source);
    }

    #[test]
    fn recomputing_own_hash_does_not_authorize_changed_parent_evidence() {
        let problem=problem();let step=step(&problem);let spec=specification();
        for field in ["prepared_execution_digest","accepted_charge_field_digest","accepted_source_state_digest",
            "view_identity_digest","current_balance_certificate_digest","capsule_hash","capsule_bytes","package_bytes","manifest_bytes"] {
            let mut receipt=ready(&problem);
            match field {
                "prepared_execution_digest"=>receipt.plan.parent.source.prepared_execution_digest=pin('9'),
                "accepted_charge_field_digest"=>receipt.plan.parent.source.accepted_charge_field_digest=pin('9'),
                "accepted_source_state_digest"=>receipt.plan.parent.source.accepted_source_state_digest=pin('9'),
                "view_identity_digest"=>receipt.plan.parent.source.view_identity_digest=pin('9'),
                "current_balance_certificate_digest"=>receipt.plan.parent.source.current_balance_certificate_digest=pin('9'),
                "capsule_hash"=>receipt.plan.parent.evidence_capsule.object_ref=hash('9'),
                "capsule_bytes"=>receipt.plan.parent.evidence_capsule.byte_count+=1,
                "package_bytes"=>receipt.plan.parent.owner.package.byte_count+=1,
                "manifest_bytes"=>receipt.plan.parent.owner.output_manifest.byte_count+=1,
                _=>unreachable!(),
            }
            receipt.plan_fingerprint=fingerprint(&receipt.plan).unwrap();
            receipt.validate().unwrap();
            // Canonical DTO consistency is intentionally weaker than an independent durable parent check.
            receipt.validate_for_accepted_input(&spec,"task-accepted",&step,&problem).unwrap();
            assert!(receipt.validate_for(&spec,"task-accepted",&step,&problem,&parent()).is_err(),"{field}");
            assert_ne!(receipt.binding().unwrap(),ready(&problem).binding().unwrap());
        }
    }

    #[test]
    fn readiness_refuses_cross_project_locator_and_task_rebinding() {
        let problem=problem();let step=step(&problem);let receipt=ready(&problem);
        let mut spec=specification();spec.snapshot.project_id=crate::ProjectId::parse("project-other").unwrap();
        assert!(RetainedCurrentPreparationReceipt::ready(&spec,"task-accepted",&step,&problem,parent()).is_err());
        let mut other=parent();other.owner.run_id="run-other".into();
        assert!(RetainedCurrentPreparationReceipt::ready(&specification(),"task-accepted",&step,&problem,other).is_err());
        assert!(receipt.validate_for(&specification(),"task-other",&step,&problem,&parent()).is_err());
        let mut spec=specification();spec.run_id=crate::RunId::parse("run-other-child").unwrap();
        assert!(receipt.validate_for(&spec,"task-accepted",&step,&problem,&parent()).is_err());
    }

    #[test]
    fn sampling_fingerprint_covers_actual_target_positions_and_connectivity() {
        let problem=problem();let first=ready(&problem);let mut changed=problem.clone();
        changed.geometry_assets.as_mut().unwrap().fem_mesh_assets[0].mesh.as_mut().unwrap().nodes[0][0]+=0.1e-9;
        let second=ready(&changed);
        assert_ne!(first.plan.sampling_fingerprint,second.plan.sampling_fingerprint);
        assert_ne!(first.plan.carrier_fingerprint,second.plan.carrier_fingerprint);
        assert_eq!(first.plan.parent,second.plan.parent);
        assert!(first.validate_for(&specification(),"task-accepted",&step(&changed),&changed,&parent()).is_err());
        let mut changed_plan=step(&problem);
        let fullmag_ir::BackendPlanIR::AntennaRetainedCurrentFieldInspection(operation)=
            &mut changed_plan.execution_plan.as_mut().unwrap().backend_plan else {panic!()};
        operation.field_sampling.cells=fullmag_ir::FemConnectivityIR::from_tet4(vec![[1,0,2,3]]);
        assert!(RetainedCurrentPreparationReceipt::ready(&specification(),"task-accepted",&changed_plan,&problem,parent()).is_err());
    }

    #[test]
    fn readiness_rejects_legacy_or_dynamic_step_contracts_and_schema_relabeling() {
        let problem=problem();
        for field in ["kind","enabled","status","horizon","output","acceptance","acquisition","version"] {
            let mut step=step(&problem);let mut spec=specification();
            match field {
                "kind"=>step.kind=StudyStepKind::ClosedLoopInspection {stage_id:"inspect_antenna".into(),port_mode_id:"port".into(),output_id:"inspection".into()},
                "enabled"=>step.enabled=false,"status"=>step.status=StudyStepLoweringStatus::Disabled,
                "horizon"=>step.until_seconds=Some(1e-9),"output"=>step.outputs.clear(),
                "acceptance"=>step.acceptance=StudyAcceptancePolicy::Converged,
                "acquisition"=>step.acquisition=StudyAcquisitionPolicy::Shared,
                "version"=>spec.study.plan_version=fullmag_authoring::STUDY_PLAN_SCHEMA_VERSION.into(),_=>unreachable!(),
            }
            assert!(RetainedCurrentPreparationReceipt::ready(&spec,"task-accepted",&step,&problem,parent()).is_err(),"{field}");
        }
        for schema in ["closed_loop_preparation_receipt.v1","retained_current_preparation_receipt.v2"] {
            let mut receipt=ready(&problem);receipt.schema_version=schema.into();assert!(receipt.validate().is_err());
        }
        let mut receipt=ready(&problem);receipt.plan.parent.evidence_capsule.byte_count=0;
        receipt.plan_fingerprint=fingerprint(&receipt.plan).unwrap();assert!(receipt.validate().is_err());
    }
}
