//! Schemas for materializing an authored Study against immutable execution profiles.
//!
//! Request and response fields keep the canonical domain IR as their runtime
//! representation. The small `ToSchema` shadows below describe those domain
//! values to OpenAPI without adding another runtime model.

use std::collections::BTreeMap;

use fullmag_authoring::StudyPlan;
use fullmag_ir::{ExecutionRequestLayerIR, MaterializedExecutionRequestIR, ProblemIR};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use super::compute_profiles::{
    ComputeParallelismSchema, ComputePlacementSchema, ComputeTargetSchema, CpuAffinitySchema,
    CpuCorePolicySchema, ExecutionBackendSchema, ExecutionDeviceSchema, ExecutionModeSchema,
    ExecutionPrecisionSchema, ExecutionProfileSchema, ExecutionRequestPatchSchema,
    GpuSelectorSchema, RequestedThreadsSchema,
};

#[derive(Debug, Clone, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct ComputePreviewRequest {
    #[schema(minimum = 0)]
    pub expected_profile_catalog_revision: u64,
    /// The canonical StudyPlan transport is opaque here; fullmag-authoring
    /// owns its deserialization and validation rules.
    #[schema(value_type = BTreeMap<String, serde_json::Value>)]
    pub study_plan: StudyPlan,
    #[schema(max_items = 256)]
    pub inputs: Vec<ComputePreviewInput>,
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct ComputePreviewInput {
    pub step_id: String,
    /// ProblemIR remains the canonical transport and is validated by the Rust
    /// domain type; OpenAPI treats its established JSON object shape as opaque.
    #[schema(value_type = BTreeMap<String, serde_json::Value>)]
    pub problem: ProblemIR,
    /// Missing layers mean an empty override list, as in ExecutionRequestLayerIR.
    #[serde(default)]
    #[schema(required = false, value_type = Vec<ExecutionLayerSchema>)]
    pub layers: Vec<ExecutionRequestLayerIR>,
}

/// OpenAPI shape for an incoming ExecutionRequestLayerIR. Its request patch is
/// optional because the canonical IR defaults an omitted patch to empty.
#[derive(ToSchema)]
pub struct ExecutionLayerSchema {
    pub origin: ExecutionOriginSchema,
    #[schema(required = false)]
    pub request: ExecutionRequestPatchSchema,
}

#[derive(ToSchema)]
pub struct ExecutionOriginSchema {
    pub kind: ExecutionOriginKindSchema,
    pub location: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionOriginKindSchema {
    ProductDefault,
    Profile,
    Script,
    Study,
    Step,
    Submit,
    Cli,
    LegacyEnv,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ComputeAdmissionState {
    /// Preview materializes requested intent; it does not evaluate host
    /// inventory, admission, allocation, or executable readiness.
    NotEvaluated,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct ComputePreviewResource {
    pub schema_version: String,
    pub preview_id: String,
    pub source_digest: String,
    pub profile_catalog_revision: u64,
    pub study_problem_catalog: BTreeMap<String, serde_json::Value>,
    pub study_catalog_sha256: String,
    pub steps: Vec<ComputePreviewStep>,
    pub admission_state: ComputeAdmissionState,
    pub blocking_reasons: Vec<String>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct ComputePreviewStep {
    pub step_id: String,
    #[schema(value_type = ExecutionMaterializationSchema)]
    pub execution: MaterializedExecutionRequestIR,
}

/// MaterializedExecutionRequestIR always has a bound immutable profile and
/// its digest in a full Study preview, although the general IR type permits
/// those fields to be absent in other contexts.
#[derive(ToSchema)]
pub struct ExecutionMaterializationSchema {
    pub schema_version: String,
    pub profile: ExecutionProfileSchema,
    pub profile_sha256: String,
    pub layers: Vec<MaterializedExecutionLayerSchema>,
    pub requested: RequestedExecutionPreviewSchema,
    pub origins: BTreeMap<String, ExecutionOriginSchema>,
}

/// The materialized output always serializes its request member, including an
/// empty patch, unlike the optional input form in ExecutionLayerSchema.
#[derive(ToSchema)]
pub struct MaterializedExecutionLayerSchema {
    pub origin: ExecutionOriginSchema,
    pub request: ExecutionRequestPatchSchema,
}

#[derive(ToSchema)]
pub struct RequestedExecutionPreviewSchema {
    pub backend: ExecutionBackendSchema,
    pub device: ExecutionDeviceSchema,
    pub precision: ExecutionPrecisionSchema,
    pub mode: ExecutionModeSchema,
    pub resources: ComputeResourcesPreviewSchema,
}

/// Fully materialized resource intent. This is deliberately separate from
/// ComputeResourcePatchSchema, whose optional members represent a sparse patch.
#[derive(ToSchema)]
pub struct ComputeResourcesPreviewSchema {
    pub schema_version: String,
    pub target: ComputeTargetSchema,
    pub cpu: CpuResourcesPreviewSchema,
    #[schema(required = false, nullable = false)]
    pub gpu: Option<GpuResourcesPreviewSchema>,
    pub ram: MemoryReservationPreviewSchema,
    pub scratch: MemoryReservationPreviewSchema,
    pub parallelism: ComputeParallelismSchema,
    pub placement: ComputePlacementSchema,
}

#[derive(ToSchema)]
pub struct CpuResourcesPreviewSchema {
    pub threads: RequestedThreadsSchema,
    #[schema(required = false, nullable = false)]
    pub core_policy: Option<CpuCorePolicySchema>,
    pub affinity: CpuAffinitySchema,
    #[schema(required = false, nullable = false, value_type = u64, minimum = 0, maximum = 4294967295_u64)]
    pub numa_node: Option<u32>,
    pub native_threads: RequestedThreadsSchema,
    pub blas_threads: RequestedThreadsSchema,
}

#[derive(ToSchema)]
pub struct GpuResourcesPreviewSchema {
    pub selector: GpuSelectorSchema,
    pub device_uuids: Vec<String>,
    #[schema(value_type = u64, minimum = 1, maximum = 4294967295_u64)]
    pub devices_per_task: u32,
    #[schema(required = false, nullable = false, minimum = 1)]
    pub vram_per_device_bytes: Option<u64>,
}

#[derive(ToSchema)]
pub struct MemoryReservationPreviewSchema {
    #[schema(required = false, nullable = false, minimum = 1)]
    pub reservation_bytes: Option<u64>,
}
