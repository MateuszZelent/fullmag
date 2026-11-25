//! Parent-bound H-only readiness. DTO consistency never authenticates durable source history.
use crate::{AcceptedRunPreparationSource, PreparationBinding, PreparationReceiptError, RunSpecification};
use fullmag_antenna_artifacts::retained_current::RetainedCurrentParent;
use fullmag_authoring::{StudyAcceptancePolicy, StudyAcquisitionPolicy, StudyOutputPort, StudyPortDataKind, StudyStepKind};
use fullmag_ir::ProblemIR;
use fullmag_plan::{StudyStepExecutionPlan, StudyStepLoweringStatus};
use serde::{Deserialize, Serialize};

pub const RETAINED_ASSET_FIELD_PREPARATION_PLAN_SCHEMA: &str = "retained_asset_field_preparation_plan.v1";
pub const RETAINED_ASSET_FIELD_PREPARATION_SCHEMA: &str = "retained_asset_field_preparation_receipt.v1";
pub const RETAINED_ASSET_FIELD_PREPARATION_BINDING_SCHEMA: &str = "retained_asset_field_preparation_binding.v1";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct RetainedAssetFieldPreparationPlan {
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
    pub preparation_asset: fullmag_ir::AntennaSourcePreparationAssetRefIR,
    pub source_preparation: fullmag_ir::AntennaSourcePreparationReceiptPinsIR,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct RetainedAssetFieldPreparationReceipt {
    pub schema_version: String,
    pub preparation_id: String,
    pub plan_fingerprint: String,
    pub plan: RetainedAssetFieldPreparationPlan,
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

impl RetainedAssetFieldPreparationReceipt {
    /// The caller must obtain `parent` from the durable authenticated reader and compare source intent.
    pub fn ready(
        specification: &RunSpecification,
        canonical_task_id: &str,
        step: &StudyStepExecutionPlan,
        problem: &ProblemIR,
        parent: RetainedCurrentParent,
        source_preparation: fullmag_ir::AntennaSourcePreparationReceiptPinsIR,
    ) -> Result<Self, PreparationReceiptError> {
        let plan = Self::expected_plan(specification, step, problem, &parent, &source_preparation)?;
        let receipt = Self {
            schema_version: RETAINED_ASSET_FIELD_PREPARATION_SCHEMA.into(),
            preparation_id: preparation_id_for_task(canonical_task_id)?,
            plan_fingerprint: fingerprint(&plan)?,
            plan,
        };
        receipt.validate_for(specification, canonical_task_id, step, problem, &parent, &source_preparation)?;
        Ok(receipt)
    }

    fn expected_plan(
        specification: &RunSpecification,
        step: &StudyStepExecutionPlan,
        problem: &ProblemIR,
        parent: &RetainedCurrentParent,
        source_preparation: &fullmag_ir::AntennaSourcePreparationReceiptPinsIR,
    ) -> Result<RetainedAssetFieldPreparationPlan, PreparationReceiptError> {
        let StudyStepKind::RetainedCurrentFieldInspection { stage_id, port_mode_id, output_id } = &step.kind else {
            return Err(failure("retained-asset field preparation requires its typed H-only operation"));
        };
        if specification.study.plan_version != fullmag_authoring::STUDY_PLAN_SCHEMA_VERSION_V4
            || !step.enabled || step.status != StudyStepLoweringStatus::Planned
            || step.until_seconds.is_some() || !step.inputs.is_empty()
            || step.outputs != [StudyOutputPort { port_id: "inspection".into(), data_kind: StudyPortDataKind::Artifact }]
            || step.acceptance != StudyAcceptancePolicy::Any
            || step.acquisition != StudyAcquisitionPolicy::Exclusive {
            return Err(failure("retained-asset field preparation requires an enabled planned v4 static inspection with Any/Exclusive and one inspection Artifact output"));
        }
        parent.validate_metadata().map_err(|error| failure(error.to_string()))?;
        if parent.owner.project_id != specification.snapshot.project_id.as_str() {
            return Err(failure("retained-asset field parent belongs to another accepted project"));
        }
        // Fingerprint the exact typed operation, preserving both existing v1 receipt bytes
        // and the direct family's distinct identity without serializing an adapter enum.
        let carrier = fullmag_plan::plan(problem).map_err(|error| failure(error.to_string()))?;
        let (stage, preparation_asset, field_sampling, operation_fingerprint) = match &carrier.backend_plan {
            fullmag_ir::BackendPlanIR::AntennaRetainedPreparationFieldInspection(_) => {
                let operation = fullmag_plan::validate_retained_preparation_field_operation(
                    problem, stage_id, port_mode_id, output_id).map_err(|error| failure(error.to_string()))?;
                let fingerprint = fingerprint(&operation)?;
                (operation.stage, operation.preparation_asset, operation.field_sampling, fingerprint)
            }
            fullmag_ir::BackendPlanIR::AntennaRetainedDirectFieldInspection(_) => {
                let operation = fullmag_plan::validate_retained_direct_field_operation(
                    problem, stage_id, port_mode_id, output_id).map_err(|error| failure(error.to_string()))?;
                let fingerprint = fingerprint(&operation)?;
                (operation.stage, operation.preparation_asset, operation.field_sampling, fingerprint)
            }
            _ => return Err(failure("retained-asset field receipt requires its exact typed asset-backed operation")),
        };
        let mut assets = specification.immutable_assets.iter().filter(|asset| asset.asset_id == preparation_asset.asset_id);
        let asset = assets.next().ok_or_else(|| failure("retained-asset field source asset is absent from immutable RunSpec"))?;
        if assets.next().is_some() || asset.content_sha256 != preparation_asset.content_sha256 {
            return Err(failure("retained-asset field source asset differs from its exact immutable RunSpec pin"));
        }
        let source = stage.retained_current_source.as_ref()
            .ok_or_else(|| failure("retained-asset field operation has no source locator"))?;
        if !parent.owner.matches_source(source) {
            return Err(failure("retained-asset field parent differs from the exact authored historical source locator"));
        }
        if source_preparation.run_id != parent.owner.run_id || source_preparation.task_id != parent.owner.task_id
            || source_preparation.step_id != parent.owner.study_step_id {
            return Err(failure("retained-asset field receipt projection differs from its historical parent"));
        }
        let errors = source_preparation.validation_errors("source_preparation");
        if !errors.is_empty() { return Err(failure(errors.join("; "))); }
        let definition = problem.current_modules.iter().find_map(|module| match module {
            fullmag_ir::CurrentModuleIR::CurrentTransport { name, definition: Some(definition), .. }
                if name == &stage.current_transport_id => Some(definition),
            _ => None,
        }).ok_or_else(|| failure("retained-asset field source transport is absent"))?;
        let Some(fullmag_ir::ConservativeCurrentSourceIR::RetainedPreparationAsset(authored_source)) = definition.conservative_current_source.as_ref()
            else { return Err(failure("retained-asset field requires its explicit frozen source kind")); };
        if &authored_source.historical_preparation != source_preparation
            || authored_source.preparation_asset != preparation_asset {
            return Err(failure("retained-asset field preparation differs from its accepted historical source pins"));
        }
        if step.execution_plan.as_ref() != Some(&carrier) {
            return Err(failure("retained-asset field preparation carrier differs from immutable accepted lowering"));
        }
        let problem_fingerprint = fingerprint(problem)?;
        Ok(RetainedAssetFieldPreparationPlan {
            schema_version: RETAINED_ASSET_FIELD_PREPARATION_PLAN_SCHEMA.into(),
            source: AcceptedRunPreparationSource::for_study_step(specification, &step.step_id, &problem_fingerprint)?,
            problem_fingerprint,
            carrier_fingerprint: fingerprint(&carrier)?,
            operation_fingerprint,
            sampling_fingerprint: fingerprint(&field_sampling)?,
            stage_id: stage_id.clone(), port_mode_id: port_mode_id.clone(), output_id: output_id.clone(),
            parent: parent.clone(),
            preparation_asset: preparation_asset.clone(),
            source_preparation: source_preparation.clone(),
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
        expected_source_preparation: &fullmag_ir::AntennaSourcePreparationReceiptPinsIR,
    ) -> Result<(), PreparationReceiptError> {
        expected_parent.validate_metadata().map_err(|error| failure(error.to_string()))?;
        if &self.plan.parent != expected_parent || &self.plan.source_preparation != expected_source_preparation {
            return Err(failure("retained-asset field preparation differs from independently loaded parent evidence"));
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
            return Err(failure("retained-asset field preparation does not belong to the canonical accepted task"));
        }
        if self.plan != Self::expected_plan(specification, step, problem, &self.plan.parent, &self.plan.source_preparation)? {
            return Err(failure("retained-asset field preparation differs from immutable accepted source or sampling"));
        }
        Ok(())
    }

    /// Shape and own hashes only; no filesystem read, source authentication or numerical qualification.
    pub fn validate(&self) -> Result<(), PreparationReceiptError> {
        if self.schema_version != RETAINED_ASSET_FIELD_PREPARATION_SCHEMA
            || self.plan.schema_version != RETAINED_ASSET_FIELD_PREPARATION_PLAN_SCHEMA
            || self.plan_fingerprint != fingerprint(&self.plan)? {
            return Err(failure("retained-asset field preparation schema or plan digest mismatch"));
        }
        let task_id = self.preparation_id.strip_prefix("prep-")
            .ok_or_else(|| failure("retained-asset field preparation has no canonical task identity"))?;
        preparation_id_for_task(task_id)?;
        self.plan.source.validate()?;
        self.plan.parent.validate_metadata().map_err(|error| failure(error.to_string()))?;
        let errors = self.plan.preparation_asset.validation_errors("preparation_asset").into_iter()
            .chain(self.plan.source_preparation.validation_errors("source_preparation")).collect::<Vec<_>>();
        if !errors.is_empty() { return Err(failure(errors.join("; "))); }

        if self.plan.problem_fingerprint != self.plan.source.problem_fingerprint
            || [&self.plan.stage_id, &self.plan.port_mode_id, &self.plan.output_id]
                .into_iter().any(|value| !identifier(value))
            || [&self.plan.problem_fingerprint, &self.plan.carrier_fingerprint,
                &self.plan.operation_fingerprint, &self.plan.sampling_fingerprint]
                .into_iter().any(|value| !digest(value)) {
            return Err(failure("retained-asset field preparation identity or canonical fingerprint mismatch"));
        }
        self.binding()?;
        Ok(())
    }

    /// The binding covers the complete receipt, including every historical parent pin and byte count.
    pub fn binding(&self) -> Result<PreparationBinding, PreparationReceiptError> {
        let binding = PreparationBinding {
            schema_version: RETAINED_ASSET_FIELD_PREPARATION_BINDING_SCHEMA.into(),
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
    use sha2::{Digest, Sha256};
    use fullmag_antenna_artifacts::retained_current::{CasObjectRef, ParentCurrentDigests, ParentInspectionOwner,
        PARENT_CODEC_ID, PARENT_CODEC_VERSION, PARENT_MANIFEST_SCHEMA};
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
    fn shape() -> RetainedAssetFieldPreparationReceipt {
        // Wire-only fixture, without an authenticated parent or executable physics claim.
        let mut parent = parent();
        parent.owner.task_id = format!("task-{:x}", Sha256::digest(format!("{}\0{}", parent.owner.run_id, parent.owner.study_step_id).as_bytes()));
        let source_preparation = fullmag_ir::AntennaSourcePreparationReceiptPinsIR {
            receipt_schema_version:"task_preparation_receipt.v1".into(), run_id:parent.owner.run_id.clone(),
            task_id:parent.owner.task_id.clone(), step_id:parent.owner.study_step_id.clone(),
            input_fingerprint:hash('a'), preparation_id:format!("prep-{}", parent.owner.task_id),
            plan_fingerprint:pin('b'), payload_sha256:hash('c'), receipt_sha256:hash('d'),
        };
        let plan = RetainedAssetFieldPreparationPlan {
            schema_version:RETAINED_ASSET_FIELD_PREPARATION_PLAN_SCHEMA.into(),
            source:AcceptedRunPreparationSource {schema_version:"accepted_run_preparation_source.v1".into(),
                run_id:crate::RunId::parse("run-new-field").unwrap(), specification_fingerprint:pin('a'),
                step_id:"field".into(), problem_fingerprint:pin('b')},
            problem_fingerprint:pin('b'), carrier_fingerprint:pin('c'), operation_fingerprint:pin('d'),
            sampling_fingerprint:pin('e'), stage_id:"stage".into(), port_mode_id:"port".into(), output_id:"inspection".into(),
            preparation_asset:fullmag_ir::AntennaSourcePreparationAssetRefIR {asset_id:format!("script-file-{}", hash('f')),content_sha256:hash('a')},
            source_preparation, parent,
        };
        RetainedAssetFieldPreparationReceipt {schema_version:RETAINED_ASSET_FIELD_PREPARATION_SCHEMA.into(),
            preparation_id:"prep-task-new-field".into(), plan_fingerprint:fingerprint(&plan).unwrap(), plan}
    }
    #[test]
    fn asset_receipt_has_closed_own_schema_and_binding_covers_all_nine_source_pins() {
        let original=shape(); original.validate().unwrap();
        let bytes=serde_json::to_vec(&original).unwrap();
        assert_eq!(serde_json::from_slice::<RetainedAssetFieldPreparationReceipt>(&bytes).unwrap(),original);
        assert!(serde_json::from_slice::<crate::RetainedCurrentPreparationReceipt>(&bytes).is_err());
        for field in ["receipt_schema_version","run_id","task_id","step_id","input_fingerprint",
            "preparation_id","plan_fingerprint","payload_sha256","receipt_sha256"] {
            let mut wire=serde_json::to_value(&original).unwrap();
            wire["plan"]["source_preparation"][field]=serde_json::json!("tampered");
            let mut changed:RetainedAssetFieldPreparationReceipt=serde_json::from_value(wire).unwrap();
            changed.plan_fingerprint=fingerprint(&changed.plan).unwrap();
            assert_ne!(changed.binding().unwrap(),original.binding().unwrap(),"{field}");
            assert!(changed.validate().is_err(),"{field}");
        }
        let mut wire=serde_json::to_value(&original).unwrap();wire["native"]=serde_json::json!({});
        assert!(serde_json::from_value::<RetainedAssetFieldPreparationReceipt>(wire).is_err());
        for schema in [crate::RETAINED_CURRENT_PREPARATION_SCHEMA,"retained_asset_field_preparation_receipt.v2"] {
            let mut wrong=original.clone();wrong.schema_version=schema.into();assert!(wrong.validate().is_err());
        }
        let wrapped=crate::AcceptedPreparationReceipt::RetainedAssetField(original.clone());
        assert_eq!(wrapped.binding().unwrap(),original.binding().unwrap());
    }
}
