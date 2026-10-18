//! Shared accepted inspection integrity boundary; success is not scientific qualification.
use anyhow::{bail, Context, Result};
use fullmag_application::{TaskClaim, ResourceKind};
use fullmag_authoring::{StudyStep, StudyStepKind};
use fullmag_ir::ProblemIR;

/// The transport reserve limits retained framing/decoding copies, not native solver memory qualification.
pub fn inspection_bundle_budget(claim: &TaskClaim) -> Result<usize> {
    if claim.lease.kind != ResourceKind::Cpu || claim.lease.budget.cpu_millis == 0 || claim.lease.budget.gpu_memory_bytes != 0 {
        bail!("closed-loop inspection requires a CPU lease without GPU memory");
    }
    let maximum = claim.lease.budget.storage_bytes.min(claim.lease.budget.memory_bytes / 16)
        .min(fullmag_application::ANTENNA_INSPECTION_BUNDLE_MAX_BYTES as u64);
    let maximum = usize::try_from(maximum).context("inspection byte budget exceeds address space")?;
    if maximum == 0 { bail!("inspection requires a positive transport memory/storage reserve"); }
    Ok(maximum)
}

pub fn validate_accepted_inspection_bytes(problem:&ProblemIR, step:&StudyStep, bytes:&[u8], max_bytes:usize) -> Result<()> {
    let StudyStepKind::ClosedLoopInspection { stage_id, port_mode_id, output_id }=&step.kind else { bail!("inspection output cannot belong to a legacy solver step"); };
    let operation=fullmag_plan::validate_closed_loop_operation(problem,stage_id,port_mode_id,output_id)?;
    let fullmag_plan::AntennaFieldSolveExecutionPlan::ClosedLoopInspection { input, .. }=operation else { bail!("inspection output operation mismatch"); };
    // Budget is enforced before framing decoder allocates any retained payload copies.
    let bundle=fullmag_application::decode_antenna_inspection_bundle(bytes,max_bytes)?;
    let manifest:serde_json::Value=serde_json::from_slice(&bundle.manifest_bytes)?;
    let expected_intent=serde_json::json!({"source_revision":input.source.revision,"object_id":input.source.object_id,
        "geometry_id":input.source.geometry_id,"source_module_id":input.stage.current_transport_id,
        "mesh_digest":input.source.mesh_digest,"authored_input_digest":input.source.authored_input_digest,
        "materials_digest":input.source.materials_digest,"requested_execution":input.authored_input_preimage.get("requested_execution").context("accepted inspection has no authored execution")?});
    if manifest["requested_intent"]!=expected_intent || manifest["source_object_id"]!=input.source.object_id
        || manifest["current_transport_id"]!=input.stage.current_transport_id {
        bail!("inspection artifact source differs from immutable accepted operation");
    }
    let content_digest=manifest["content_digest"].as_str().context("inspection content identity missing")?;
    let artifacts=bundle.payloads.into_iter().map(|(relative_path,bytes)|fullmag_runner::AuxiliaryArtifact { relative_path,bytes }).collect::<Vec<_>>();
    fullmag_runner::verify_antenna_closed_loop_inspection_bytes(&bundle.manifest_bytes,&artifacts,stage_id,output_id,port_mode_id,content_digest,max_bytes)
        .map_err(|error| anyhow::anyhow!(error.to_string()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use fullmag_application::{ResourceBudget,ResourceLease,RunId,TaskRecord};
    fn claim(kind:ResourceKind,memory:u64,storage:u64,gpu:u64)->TaskClaim {
        let mut task=TaskRecord::new(RunId::parse("inspection-budget").unwrap(),"a".repeat(64)).unwrap();task.queue().unwrap();
        task.claim(ResourceLease::new("resource",kind,ResourceBudget{cpu_millis:100,memory_bytes:memory,gpu_memory_bytes:gpu,storage_bytes:storage}).unwrap()).unwrap()
    }
    #[test]
    fn inspection_transport_budget_is_cpu_and_reserves_retained_copies() {
        assert_eq!(inspection_bundle_budget(&claim(ResourceKind::Cpu,1600,200,0)).unwrap(),100);
        assert_eq!(inspection_bundle_budget(&claim(ResourceKind::Cpu,1600,70,0)).unwrap(),70);
        assert!(inspection_bundle_budget(&claim(ResourceKind::Cpu,15,70,0)).is_err());
        assert!(inspection_bundle_budget(&claim(ResourceKind::Gpu,1600,70,100)).is_err());
    }
}
